import * as fs from "node:fs";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const workflow = fs.readFileSync("templates/hy-workflow.yml", "utf-8");
for (const forbidden of [
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lock",
  "requirements.txt",
  "pyproject.toml",
  "go.mod",
  "Cargo.toml",
  "npm ci",
  "cargo test",
  "go test",
  "pytest",
  "No supported project ecosystem detected",
  "No native verification command detected",
]) assert(!workflow.includes(forbidden), `workflow must not infer or rerun project CI from ${forbidden}`);

assert(workflow.includes("hy-workflow lint --json"), "workflow must run only the centralized hy-workflow policy entry point");
console.log("setup-workflow-ecosystems: no ecosystem inference or native CI duplication");
