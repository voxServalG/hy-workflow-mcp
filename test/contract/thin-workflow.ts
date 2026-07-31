import { readFileSync } from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const main = readFileSync("src/main.ts", "utf-8");
const helper = ["cli.ts", "cli-contract.ts", "cli-presentation.ts"]
  .map(file => readFileSync(`src/helper/${file}`, "utf-8"))
  .join("\n");
const project = readFileSync("src/helper/project.ts", "utf-8");
const template = readFileSync("templates/hy-workflow.yml", "utf-8");

assert(!main.includes("renderWorkflowTemplate") && !helper.includes("renderWorkflowTemplate") && !project.includes("renderWorkflowTemplate"), "public CLI/helper must not reference the optional workflow renderer");
assert(!helper.includes("writeSharedArtifacts") && !project.includes("writeSharedArtifacts"), "helper must never write legacy shared artifacts");
assert(helper.includes('const argv = ["hy-workflow", "helper", parsed.command]'), "helper recovery and continuation must use exact argv arrays");
assert(helper.includes("projectFilesChanged: []") && project.includes("projectFilesChanged: []"), "all helper outcomes must make zero project-file changes");

// The packaged legacy template is opt-in only. Preserve its least-privilege
// security posture without treating it as a setup artifact.
for (const token of ["permissions:\n  contents: read", "persist-credentials: false", "hy-workflow lint --json"]) {
  assert(template.includes(token), `optional workflow template is missing ${token}`);
}
for (const forbidden of ["contents: write", "pull-requests: write", "id-token: write", "|| true"]) {
  assert(!template.includes(forbidden), `optional workflow template contains unsafe token ${forbidden}`);
}

console.log("thin-workflow: no default workflow injection, exact helper argv, optional template remains least privilege");
