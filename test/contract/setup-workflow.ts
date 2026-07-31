import { readFileSync } from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const main = readFileSync("src/main.ts", "utf-8");
const helperCli = ["cli.ts", "cli-contract.ts", "cli-presentation.ts"]
  .map(file => readFileSync(`src/helper/${file}`, "utf-8"))
  .join("\n");
const helperProject = readFileSync("src/helper/project.ts", "utf-8");
const publicSetup = main + "\n" + helperCli + "\n" + helperProject;

for (const token of ["runHelperCli", 'argv[0] === "helper"', 'argv[0] === "setup"', '"install"']) {
  assert(main.includes(token), `public setup compatibility alias is missing ${token}`);
}
for (const forbidden of ["runSetupCli", "./setup-cli.js", "StdioServerTransport", "@modelcontextprotocol/sdk"]) {
  assert(!main.includes(forbidden), `public setup must not enter the legacy setup/MCP path: ${forbidden}`);
}
for (const token of ["installHelperSkills", "registerHelperProject", "retireOwnedWorkflowMcp", "projectFilesChanged: []"]) {
  assert(helperCli.includes(token), `helper install is missing ${token}`);
}
for (const token of ["assertHelperResourcesExternal", "assertSafeRuntimeBoundary", "projectFiles: []", "projectFilesChanged: []"]) {
  assert(helperProject.includes(token), `external-only helper registration is missing ${token}`);
}
for (const forbidden of [".github/workflows/hy-workflow.yml", "writeSharedArtifacts", "renderWorkflowTemplate", "SHARED_PROJECT_FILES", "AGENTS.md"]) {
  assert(!publicSetup.includes(forbidden), `public setup/helper must not inject project artifact ${forbidden}`);
}

console.log("setup-workflow: setup aliases helper install with zero project writes and no MCP entrypoint");
